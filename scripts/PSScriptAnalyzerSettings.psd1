@{
    Severity = @('Error', 'Warning')
    IncludeRules = @(
        'PSAvoidUsingConvertToSecureStringWithPlainText',
        'PSAvoidUsingPlainTextForPassword',
        'PSAvoidUsingInvokeExpression',
        'PSUseDeclaredVarsMoreThanAssignments',
        'PSUseCompatibleSyntax',
        'PSUseCorrectCasing',
        'PSAvoidDefaultValueSwitchParameter',
        'PSAvoidUsingComputerNameHardcoded',
        'PSUseShouldProcessForStateChangingFunctions'
    )
}
